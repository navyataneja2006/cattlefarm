import { Router, type IRouter } from "express";
import {
  ReadThingSpeakFeedsBody,
  ReadThingSpeakFeedsResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();
const THINGSPEAK_READ_API = "https://api.thingspeak.com";
const MAX_RESULTS = 8000;

/**
 * Reads the official ThingSpeak channel feeds endpoint. A private channel's
 * Read API Key is accepted for this request only, sent upstream over HTTPS,
 * and never logged or persisted. Field labels and sensor assignments remain
 * application configuration; the feed itself keeps its field1..field8 keys.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

router.post("/thingspeak/feeds", async (req, res): Promise<void> => {
  const parsed = ReadThingSpeakFeedsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { channelId, readApiKey } = parsed.data;
  if (!/^\d+$/.test(channelId)) {
    res.status(400).json({ error: "Channel ID must contain digits only." });
    return;
  }

  const requestedResults = parsed.data.results ?? 60;
  const results = Math.min(Math.max(requestedResults, 1), MAX_RESULTS);
  const endpoint = new URL(
    `/channels/${encodeURIComponent(channelId)}/feeds.json`,
    THINGSPEAK_READ_API,
  );
  endpoint.searchParams.set("results", String(results));
  if (readApiKey?.trim()) {
    endpoint.searchParams.set("api_key", readApiKey.trim());
  }

  try {
    const response = await fetch(endpoint, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(12000),
    });
    const payload: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      const upstreamError =
        isRecord(payload) && typeof payload.error === "string"
          ? payload.error
          : "";
      const needsKey =
        response.status === 401 ||
        response.status === 403 ||
        /api.?key|private|unauthori[sz]ed|not authorized/i.test(upstreamError);
      const notFound =
        response.status === 404 || /channel.*not found/i.test(upstreamError);
      const status = needsKey ? 401 : notFound ? 404 : response.status === 400 ? 400 : 502;
      const message = needsKey
        ? "This channel is private or the Read API Key is invalid."
        : notFound
          ? "ThingSpeak channel not found."
          : response.status === 400
            ? "ThingSpeak rejected the channel request. Check the Channel ID."
            : "ThingSpeak could not return channel data. Try again shortly.";
      req.log.warn(
        { channelId, upstreamStatus: response.status },
        "ThingSpeak feed request was rejected",
      );
      res.status(status).json({ error: message });
      return;
    }

    const feedResponse = ReadThingSpeakFeedsResponse.safeParse(payload);
    if (!feedResponse.success) {
      req.log.warn({ channelId }, "ThingSpeak returned an unexpected response");
      res.status(502).json({
        error: "ThingSpeak returned an unexpected response for this channel.",
      });
      return;
    }

    res.json(feedResponse.data);
  } catch (error) {
    const timedOut =
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    req.log.warn(
      { channelId, errorName: error instanceof Error ? error.name : "unknown" },
      "ThingSpeak feed request failed",
    );
    res.status(502).json({
      error: timedOut
        ? "ThingSpeak took too long to respond. Try again."
        : "Could not reach ThingSpeak. Check your connection and try again.",
    });
  }
});

export default router;
