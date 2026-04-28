import { Hono } from "hono";
import { ZodError } from "zod";

import {
  translateWebhookToReviewEvent,
  type GiteaWebhookConfig,
  verifyWebhookSignature,
} from "./gitea-webhook.js";

export interface ServerAppOptions {
  readonly gitea?: GiteaWebhookConfig;
  readonly forgejo?: GiteaWebhookConfig;
}

function registerGiteaLikeWebhook(
  app: Hono,
  provider: "gitea" | "forgejo",
  path: string,
  config: GiteaWebhookConfig | undefined,
): void {
  app.post(path, async (c) => {
    if (!config) {
      return c.json({ accepted: false, reason: "trigger_not_configured", provider }, 503);
    }

    const payload = await c.req.text();
    const signature =
      c.req.header("x-gitea-signature-256") ?? c.req.header("x-gitea-signature") ?? undefined;

    if (!verifyWebhookSignature(payload, config.webhookSecret, signature)) {
      return c.json({ accepted: false, reason: "invalid_signature", provider }, 401);
    }

    const eventName = c.req.header("x-gitea-event");

    if (!eventName) {
      return c.json({ accepted: false, reason: "missing_event_name", provider }, 400);
    }

    const decoded: unknown = (() => {
      try {
        return JSON.parse(payload) as unknown;
      } catch {
        return undefined;
      }
    })();

    if (decoded === undefined) {
      return c.json({ accepted: false, reason: "invalid_json", provider }, 400);
    }

    let reviewEvent;
    try {
      reviewEvent = translateWebhookToReviewEvent(provider, eventName, decoded, config);
    } catch (error) {
      if (error instanceof ZodError) {
        return c.json(
          {
            accepted: false,
            reason: "invalid_payload",
            provider,
            eventName,
            issues: error.issues.map((issue) => ({
              path: issue.path,
              message: issue.message,
            })),
          },
          400,
        );
      }
      throw error;
    }

    if (!reviewEvent) {
      return c.json({ accepted: false, reason: "unsupported_event", provider, eventName }, 202);
    }

    return c.json({ accepted: true, provider, reviewEvent }, 202);
  });
}

export function createServerApp(options: ServerAppOptions = {}): Hono {
  const app = new Hono();

  app.get("/healthz", (c) => c.text("ok"));
  app.get("/readyz", (c) => c.text("ready"));

  registerGiteaLikeWebhook(app, "gitea", "/webhooks/gitea", options.gitea);
  registerGiteaLikeWebhook(app, "forgejo", "/webhooks/forgejo", options.forgejo);

  return app;
}