import { describe, expect, it } from "vitest";

import { translateP4TriggerToReviewEvent } from "../src/p4-webhook.js";

describe("translateP4TriggerToReviewEvent", () => {
  const config = {
    triggerName: "p4-main",
    workspaceId: "p4-workspace",
    depot: "//Prx/Prx_Main",
  };

  it("uses configured depot when trigger payload omits depot_path", () => {
    const event = translateP4TriggerToReviewEvent(
      { change: "6244", user: "submitter", client: "submit-client" },
      config,
    );

    expect(event?.repoRef).toBe("//Prx/Prx_Main");
    expect(event?.url).toBe("p4://Prx/Prx_Main@6244");
  });

  it("uses configured depot when trigger payload sends an empty depot_path", () => {
    const event = translateP4TriggerToReviewEvent(
      { change: "6244", depot_path: "" },
      config,
    );

    expect(event?.repoRef).toBe("//Prx/Prx_Main");
  });

  it("allows trigger payload depot_path to override configured depot", () => {
    const event = translateP4TriggerToReviewEvent(
      { change: "6244", depot_path: "//Other/Main" },
      config,
    );

    expect(event?.repoRef).toBe("//Other/Main");
  });

  it("includes depotPath and p4Workspace when configured", () => {
    const event = translateP4TriggerToReviewEvent(
      { change: "6244", user: "submitter", client: "submit-client" },
      {
        triggerName: "p4-main",
        workspaceId: "p4-workspace",
        depot: "//Prx/Prx_Main",
        workspace: "submit-client-ws",
      },
    );

    expect(event?.depotPath).toBe("//Prx/Prx_Main");
    expect(event?.p4Workspace).toBe("submit-client-ws");
  });

  it("uses payload depot_path for depotPath field", () => {
    const event = translateP4TriggerToReviewEvent(
      { change: "6244", depot_path: "//Custom/Path" },
      {
        triggerName: "p4-main",
        workspaceId: "p4-workspace",
        depot: "//Prx/Prx_Main",
      },
    );

    expect(event?.depotPath).toBe("//Custom/Path");
  });
});